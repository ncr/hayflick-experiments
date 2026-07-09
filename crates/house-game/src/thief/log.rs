//! The event LOG (docs/spec/11): a Fallout-1/2-style prose chronicle.
//!
//! A PURE projection: every line derives from one tick-stamped [`Stamped`]
//! sim event (which carries any evolving data it needs, e.g. the case
//! profile at open time), so live play, trace replay, and the clip bin all
//! render the identical log — nothing is invented, which is exactly what
//! makes the deduction engine feel fair rather than arbitrary.

use super::perception::{ActionKind, Description, Feature, Gait, Headwear, Hue, Mark, NpcId};
use super::sim::{DayPhase, GameEvent, Stamped, StopOutcome, ThiefSpec};

/// Prose for one sim event, or `None` for beats too small to chronicle
/// (footstep noises, idle glances).
pub fn narrate(spec: &ThiefSpec, s: &Stamped) -> Option<String> {
    let who = |id: NpcId| name(spec, id);
    Some(match s.ev {
        GameEvent::Stole { .. } => "You lift the strongbox.".into(),
        GameEvent::Dropped { .. } => "You set the strongbox down.".into(),
        GameEvent::Seen { by, action, .. } => match action {
            ActionKind::Stealing => format!("{} sees you at your work — the theft is witnessed!", cap(who(by))),
            ActionKind::Fleeing => format!("{} marks a figure fleeing with a burden.", cap(who(by))),
            ActionKind::Carrying => format!("{} eyes the load you carry.", cap(who(by))),
            ActionKind::Forcing | ActionKind::Fighting | ActionKind::BearingBody => {
                format!("{} sees what you are doing.", cap(who(by)))
            }
            _ => return None, // loitering glances and noises stay diegetic
        },
        GameEvent::Reported { by, to, .. } => {
            format!("{} finds {} and tells what they saw.", cap(who(by)), who(to))
        }
        GameEvent::CaseOpened { profile, .. } => {
            format!("Word is out: the watch seeks {}.", describe(&profile))
        }
        GameEvent::CaseCleared { .. } => "The watch strikes you from their description.".into(),
        GameEvent::Hailed { guard } => format!("{}: 'You there — stand fast!'", cap(who(guard))),
        GameEvent::StopBegan { guard } => format!("{} looks you up and down.", cap(who(guard))),
        GameEvent::LieCaught { .. } => "Your story unravels under his questions.".into(),
        GameEvent::BribeRefused { guard } => {
            format!("{} will not be bought — and likes you less for the offer.", cap(who(guard)))
        }
        GameEvent::StopResolved { outcome, .. } => match outcome {
            StopOutcome::Bluffed => "He grunts and waves you on.".into(),
            StopOutcome::Bribed => "Coin changes hands; he finds somewhere else to look.".into(),
            StopOutcome::CleanSearch => {
                "The search turns up nothing. You no longer fit the description.".into()
            }
            StopOutcome::Fled => "You bolt!".into(),
            StopOutcome::Caught => return None, // the Caught event carries the line
        },
        GameEvent::Caught { had_loot, .. } => {
            if had_loot {
                "Caught with the goods — the strongbox is seized, and you pay a fine.".into()
            } else {
                "They hold you, find nothing, and let you go — with a long look.".into()
            }
        }
        GameEvent::HuntStarted { guard } => format!("{} gives chase!", cap(who(guard))),
        GameEvent::PhaseChanged { phase } => match phase {
            DayPhase::Dawn => "Dawn breaks over the district.".into(),
            DayPhase::Day => "The streets fill with the day's business.".into(),
            DayPhase::Dusk => "Dusk settles; lamps are lit.".into(),
            DayPhase::Night => "Night falls; the streets empty.".into(),
        },
    })
}

fn name(spec: &ThiefSpec, id: NpcId) -> &str {
    spec.npcs
        .iter()
        .find(|n| n.id == id)
        .map(|n| n.name.as_str())
        .unwrap_or("someone")
}

fn cap(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn hue_name(h: Hue) -> &'static str {
    match h {
        Hue::Drab => "drab",
        Hue::Brown => "brown",
        Hue::Green => "green",
        Hue::Blue => "blue",
        Hue::Red => "red",
        Hue::Black => "black",
        Hue::White => "white",
    }
}

/// A wanted profile as street prose — what a poster or the log prints.
pub fn describe(d: &Description) -> String {
    let mut s = String::new();
    if d.masked == Feature::Seen(true) {
        s.push_str("a masked, ");
    } else {
        s.push_str("a ");
    }
    s.push_str(match d.headwear {
        Feature::Seen(Headwear::Hood) => "hooded figure",
        Feature::Seen(Headwear::Hat) => "figure in a hat",
        Feature::Seen(Headwear::Helmet) => "helmeted figure",
        Feature::Seen(Headwear::Bare) => "bare-headed figure",
        Feature::Unknown => "figure",
    });
    if let Feature::Seen(h) = d.top {
        s.push_str(" in ");
        s.push_str(hue_name(h));
    }
    if let Feature::Seen(b) = d.build {
        s.push_str(match b {
            super::perception::Build::Slight => ", slight of build",
            super::perception::Build::Average => ", average of build",
            super::perception::Build::Heavy => ", heavy of build",
        });
    }
    match d.gait {
        Feature::Seen(Gait::Limp) => s.push_str(", walking with a limp"),
        Feature::Seen(Gait::Swagger) => s.push_str(", with a swagger"),
        _ => {}
    }
    match d.mark {
        Feature::Seen(Mark::Brand) => s.push_str(", branded"),
        Feature::Seen(Mark::CroppedEar) => s.push_str(", with a cropped ear"),
        Feature::Seen(Mark::Scar) => s.push_str(", scarred"),
        _ => {}
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thief::sim::{spine_level, spine_trace, ThiefGame};
    use sim_core::{Runner, Simulation};

    /// The spine's log tells the whole story, in order, from real events
    /// only — and replays identically.
    #[test]
    fn the_spine_narrates_the_whole_arc() {
        let mut r = Runner::new(ThiefGame::new(spine_level()));
        r.feed(spine_trace(false));
        r.run_ticks(6000);
        let spec = spine_level();
        let lines: Vec<String> = r
            .sim
            .events
            .iter()
            .filter_map(|s| narrate(&spec, s))
            .collect();
        let all = lines.join("\n");
        let beats = [
            "You lift the strongbox.",
            "the theft is witnessed",
            "tells what they saw",
            "Word is out: the watch seeks",
            "stand fast",
            "the strongbox is seized",
        ];
        let mut at = 0usize;
        for b in beats {
            let found = all[at..].find(b).unwrap_or_else(|| {
                panic!("log must contain {b:?} after byte {at}:\n{all}")
            });
            at += found;
        }
        // The wanted line prints the merged profile's actual features.
        assert!(
            all.contains("hooded figure in green"),
            "the description must read back the profile:\n{all}"
        );
        let _ = r.sim.state_hash();
    }

    #[test]
    fn describe_reads_a_profile_back() {
        use crate::thief::perception::{Build, Feature};
        let d = Description {
            build: Feature::Seen(Build::Heavy),
            top: Feature::Seen(Hue::Black),
            bottom: Feature::Unknown,
            headwear: Feature::Seen(Headwear::Hood),
            masked: Feature::Seen(true),
            gait: Feature::Seen(Gait::Limp),
            mark: Feature::Seen(Mark::Brand),
        };
        assert_eq!(
            describe(&d),
            "a masked, hooded figure in black, heavy of build, walking with a limp, branded"
        );
        assert_eq!(describe(&Description::UNKNOWN), "a figure");
    }
}
