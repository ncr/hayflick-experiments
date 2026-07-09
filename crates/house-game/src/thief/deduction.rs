//! The correlation engine — observations become Cases
//! (docs/spec/05b-memory-deduction.md, locked round 6).
//!
//! The guards' case file is a DERIVED aggregate: reported [`Observation`]s
//! are ingested in canonical order and clustered — by fuzzy subject match
//! plus spatiotemporal proximity — into [`Case`]s: an aggregated suspect
//! profile, linked events, and a rising confidence. "Casing at dusk" ⊕
//! "robbery overnight" ⊕ "matching hood" → one suspect the town now hunts.
//!
//! Determinism is the whole point of this M0 spike (docs/spec/12): ingestion
//! order is canonical (the sim reports in tick order; ties resolved by push
//! order), clustering iterates cases in id order with lowest-id tie-break,
//! and all arithmetic is integer — `state_hash` replays bit-identically and
//! is portable across machines.

use super::grid::CellPos;
use super::perception::{match_score, Description, Feature, Observation, MATCH_MAX};
use sim_core::Tick;

pub type CaseId = u16;
pub type ObsId = u32;

/// Merge threshold: how related an observation must look to an existing case
/// before it folds in rather than opening a new one.
pub const MERGE_THRESHOLD: i32 = 30;
/// Spatiotemporal proximity window: events within this many cells
/// (Chebyshev, any floor) and ticks of each other feel "connected".
pub const PROX_CELLS: i32 = 12;
pub const PROX_TICKS: u64 = 3600; // one in-game minute-block at 60 Hz; tunable
/// Proximity contribution to the merge score when inside the window.
/// Deliberately ABOVE `MERGE_THRESHOLD`: a subject-less forensic discovery
/// (the dawn strongbox find) joins a nearby case on proximity alone — the
/// vision doc's "the two facts meet". A conflicting description still
/// outweighs it (subject conflicts go hard negative).
pub const PROX_BONUS: i32 = 40;
/// Confidence decay: every `DECAY_INTERVAL` ticks a case loses confidence —
/// slower when severe (05b: high-salience crimes decay far slower).
pub const DECAY_INTERVAL: u64 = 3600;
/// A case below this confidence goes cold: kept (it can be re-warmed by a
/// fresh matching observation) but exerts no scrutiny.
pub const COLD_FLOOR: u16 = 5;
/// Only an observation at least this alarming can OPEN a case — the file is
/// about crimes, not people-watching. Less alarming observations may still
/// MERGE into an existing matching case (the dusk casing joining the dawn
/// discovery), or wait as orphans until a case opens nearby.
pub const CASE_OPEN_SALIENCE: u8 = 60;

/// A per-field-confidence merged suspect profile. Each field remembers how
/// clear the read that set it was, so a sharper look overrides a hazier one
/// deterministically (never "last writer wins by iteration accident").
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
struct FieldConf {
    build: u8,
    top: u8,
    bottom: u8,
    headwear: u8,
    masked: u8,
    gait: u8,
    mark: u8,
}

#[derive(Clone, Debug)]
pub struct Case {
    pub id: CaseId,
    /// The merged suspect profile — what wanted posters print (module 11).
    pub profile: Description,
    field_conf: FieldConf,
    /// Linked observations, in ingestion order.
    pub observations: Vec<ObsId>,
    /// Rising belief that this cluster is one real suspect: fed by every
    /// merged observation (confidence × salience), eroded by decay.
    pub confidence: u16,
    /// Worst linked deed (max salience seen) — scales scrutiny AND slows
    /// decay.
    pub severity: u8,
    /// Where the case's latest linked event happened (search anchor).
    pub last_at: CellPos,
    pub last_when: Tick,
}

impl Case {
    pub fn cold(&self) -> bool {
        self.confidence < COLD_FLOOR
    }
}

/// The constabulary's derived case file (05b). One per town/run.
#[derive(Clone, Debug, Default)]
pub struct CaseFile {
    pub cases: Vec<Case>,
    /// Every ingested observation, in ingestion order (ObsId = index).
    pub pool: Vec<Observation>,
    /// Reported observations not yet linked to any case (too mild to open
    /// one, no match yet). Retried, in order, whenever a new case opens —
    /// this is how "the two facts meet" when the mild fact arrived first.
    pub orphans: Vec<ObsId>,
    last_decay: u64,
}

impl CaseFile {
    pub fn new() -> CaseFile {
        CaseFile::default()
    }

    /// Ingest one reported observation; returns the case it landed in, or
    /// `None` if it orphaned. CALL ORDER IS THE CONTRACT: the sim reports
    /// observations in tick order (ties: emission order); replaying the same
    /// report stream reproduces the same cases bit-for-bit.
    pub fn ingest(&mut self, obs: Observation) -> Option<CaseId> {
        let oid = self.pool.len() as ObsId;
        self.pool.push(obs);

        // Score against every live case, id order; best score wins, lowest
        // id breaks ties (order-stable by construction). A CONFLICTING
        // description (negative subject score) never merges, however close —
        // a visibly different-looking person near the scene must not fold
        // into the case and rewrite its profile (the innocent brown-coat
        // stroller stays a stranger; deliberate false descriptions are
        // module-10 framing, which will write MATCHING features).
        let mut best: Option<(i32, usize)> = None;
        for (i, case) in self.cases.iter().enumerate() {
            let subject = match_score(&case.profile, &obs.subject);
            if subject < 0 {
                continue;
            }
            let dx = (case.last_at.x as i32 - obs.at.x as i32).abs();
            let dz = (case.last_at.z as i32 - obs.at.z as i32).abs();
            let dt = obs.when.0.abs_diff(case.last_when.0);
            let near = dx.max(dz) <= PROX_CELLS && dt <= PROX_TICKS;
            let score = subject + if near { PROX_BONUS } else { 0 };
            if score >= MERGE_THRESHOLD && best.map(|(s, _)| score > s).unwrap_or(true) {
                best = Some((score, i));
            }
        }

        match best {
            Some((_, i)) => {
                self.merge_into(i, oid);
                Some(self.cases[i].id)
            }
            None if obs.salience >= CASE_OPEN_SALIENCE => {
                let id = self.cases.len() as CaseId;
                self.cases.push(Case {
                    id,
                    profile: Description::UNKNOWN,
                    field_conf: FieldConf::default(),
                    observations: Vec::new(),
                    confidence: 0,
                    severity: 0,
                    last_at: obs.at,
                    last_when: obs.when,
                });
                let ci = self.cases.len() - 1;
                self.merge_into(ci, oid);
                // A case just opened: earlier orphaned facts get their
                // chance to meet it (canonical order; the case's profile
                // and anchor evolve as they fold in).
                let orphans = std::mem::take(&mut self.orphans);
                for o in orphans {
                    let cand = self.pool[o as usize];
                    let subject = match_score(&self.cases[ci].profile, &cand.subject);
                    let dx = (self.cases[ci].last_at.x as i32 - cand.at.x as i32).abs();
                    let dz = (self.cases[ci].last_at.z as i32 - cand.at.z as i32).abs();
                    let dt = cand.when.0.abs_diff(self.cases[ci].last_when.0);
                    let near = dx.max(dz) <= PROX_CELLS && dt <= PROX_TICKS;
                    let score = subject + if near { PROX_BONUS } else { 0 };
                    if subject >= 0 && score >= MERGE_THRESHOLD {
                        self.merge_into(ci, o);
                    } else {
                        self.orphans.push(o);
                    }
                }
                Some(id)
            }
            None => {
                self.orphans.push(oid);
                None
            }
        }
    }

    fn merge_into(&mut self, ci: usize, oid: ObsId) {
        let obs = self.pool[oid as usize];
        let case = &mut self.cases[ci];
        case.observations.push(oid);
        // Profile merge: per field, the clearer read wins (>= keeps the
        // newest of equal clarity — still deterministic, ingestion-ordered).
        macro_rules! fold {
            ($field:ident) => {
                if let Feature::Seen(v) = obs.subject.$field {
                    if obs.confidence >= case.field_conf.$field {
                        case.profile.$field = Feature::Seen(v);
                        case.field_conf.$field = obs.confidence;
                    }
                }
            };
        }
        fold!(build);
        fold!(top);
        fold!(bottom);
        fold!(headwear);
        fold!(masked);
        fold!(gait);
        fold!(mark);
        // Belief rises with how clear and how alarming the report was.
        let add = (obs.confidence as u32 * obs.salience as u32 / 100) as u16;
        case.confidence = case.confidence.saturating_add(add);
        case.severity = case.severity.max(obs.salience);
        // The anchor only moves FORWARD in time: an old orphaned fact
        // joining late must not drag the case back to where it happened.
        if obs.when >= case.last_when {
            case.last_at = obs.at;
            case.last_when = obs.when;
        }
    }

    /// Periodic decay (05b: memories and heat fade unless reinforced; high
    /// salience decays far slower). Call once per tick; internally strided.
    pub fn decay_tick(&mut self, now: Tick) {
        if now.0 < self.last_decay + DECAY_INTERVAL {
            return;
        }
        self.last_decay = now.0;
        for case in &mut self.cases {
            let rate = if case.severity >= 80 {
                1
            } else if case.severity >= 50 {
                2
            } else {
                4
            };
            case.confidence = case.confidence.saturating_sub(rate);
        }
    }

    /// 05b's scrutiny rule: seeing someone matching a live profile draws
    /// scrutiny ∝ match strength × profile confidence × severity. The max
    /// over live cases — what a guard's stop-threshold compares against
    /// (05c). Shed the matched features and this collapses: the disguise
    /// loop's payoff, executable.
    pub fn scrutiny(&self, seen: &Description) -> i32 {
        let mut worst = 0i32;
        for case in &self.cases {
            if case.cold() {
                continue;
            }
            let m = match_score(&case.profile, seen).max(0);
            let s = m * case.confidence.min(200) as i32 * case.severity as i32 / (MATCH_MAX * 100);
            worst = worst.max(s);
        }
        worst
    }

    /// FNV-1a over the full canonical engine state — the replay oracle.
    pub fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let mut eat = |b: u8| {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        };
        for byte in (self.pool.len() as u64).to_le_bytes() {
            eat(byte);
        }
        for obs in &self.pool {
            obs.eat_into(&mut eat);
        }
        for case in &self.cases {
            eat(case.id as u8);
            eat((case.id >> 8) as u8);
            case.profile.eat_into(&mut eat);
            for f in [
                case.field_conf.build,
                case.field_conf.top,
                case.field_conf.bottom,
                case.field_conf.headwear,
                case.field_conf.masked,
                case.field_conf.gait,
                case.field_conf.mark,
            ] {
                eat(f);
            }
            for &o in &case.observations {
                for byte in o.to_le_bytes() {
                    eat(byte);
                }
            }
            eat(case.confidence as u8);
            eat((case.confidence >> 8) as u8);
            eat(case.severity);
            eat(case.last_at.x as u8);
            eat((case.last_at.x >> 8) as u8);
            eat(case.last_at.z as u8);
            eat((case.last_at.z >> 8) as u8);
            eat(case.last_at.floor as u8);
            for byte in case.last_when.0.to_le_bytes() {
                eat(byte);
            }
        }
        for &o in &self.orphans {
            for byte in o.to_le_bytes() {
                eat(byte);
            }
        }
        for byte in self.last_decay.to_le_bytes() {
            eat(byte);
        }
        h
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thief::perception::{ActionKind, Build, Gait, Headwear, Hue, Mark, NpcId, Source};

    fn hooded() -> Description {
        Description {
            build: Feature::Seen(Build::Average),
            top: Feature::Seen(Hue::Green),
            bottom: Feature::Unknown,
            headwear: Feature::Seen(Headwear::Hood),
            masked: Feature::Unknown,
            gait: Feature::Unknown,
            mark: Feature::Unknown,
        }
    }

    fn obs(observer: NpcId, subject: Description, action: ActionKind, at: (i16, i16), when: u64, conf: u8) -> Observation {
        Observation {
            observer,
            subject,
            action,
            at: CellPos::new(at.0, at.1, 0),
            when: Tick(when),
            confidence: conf,
            salience: action.base_salience(),
            source: Source::Direct,
        }
    }

    /// The 01-vision fantasy, executable: a neighbour half-remembers a
    /// stranger casing; at dawn the theft is discovered; a matching hood was
    /// seen fleeing. The three facts must meet in ONE case whose profile is
    /// the merged description.
    fn toy_scenario(file: &mut CaseFile) {
        // Dusk: neighbour A sees a hooded figure casing the silversmith's.
        file.ingest(obs(1, hooded(), ActionKind::Casing, (10, 10), 1_000, 60));
        // Overnight burglary discovered at dawn: forced strongbox, nobody
        // seen — subject Unknown, pure forensics (TraceFound).
        file.ingest(obs(2, Description::UNKNOWN, ActionKind::TraceFound, (11, 9), 5_000 - 1_000, 90));
        // Actually reported a bit after the casing sighting, same night:
        // C saw a hooded figure fleeing with a sack two streets over.
        let fleeing = Description { gait: Feature::Seen(Gait::Normal), ..hooded() };
        file.ingest(obs(3, fleeing, ActionKind::Fleeing, (18, 14), 4_200, 45));
    }

    #[test]
    fn toy_scenario_forms_one_case_with_merged_profile() {
        let mut file = CaseFile::new();
        toy_scenario(&mut file);
        assert_eq!(file.cases.len(), 1, "the three facts must meet in one case: {:#?}", file.cases);
        let case = &file.cases[0];
        assert_eq!(case.observations.len(), 3);
        // The profile merged the hood/coat from the sightings…
        assert_eq!(case.profile.headwear, Feature::Seen(Headwear::Hood));
        assert_eq!(case.profile.top, Feature::Seen(Hue::Green));
        // …and the gait only the fleeing witness caught.
        assert_eq!(case.profile.gait, Feature::Seen(Gait::Normal));
        // Severity pinned by the worst deed (the forced strongbox trace).
        assert_eq!(case.severity, ActionKind::TraceFound.base_salience());
        assert!(case.confidence > 0);
    }

    #[test]
    fn scrutiny_collapses_when_the_matched_features_are_shed() {
        let mut file = CaseFile::new();
        toy_scenario(&mut file);
        // Walking around still hooded in the green coat: high scrutiny.
        let wearing_it = file.scrutiny(&hooded());
        assert!(wearing_it > 0);
        // Change coat, drop the hood (05b layer 1 shed): scrutiny collapses.
        let changed = Description {
            top: Feature::Seen(Hue::Brown),
            headwear: Feature::Seen(Headwear::Bare),
            ..hooded()
        };
        let after_change = file.scrutiny(&changed);
        assert!(
            after_change < wearing_it / 4,
            "shedding matched features must collapse exposure: {wearing_it} → {after_change}"
        );
        // But a brand on the profile keys through clothes (05c hook).
        let mut branded = CaseFile::new();
        let mut o = obs(1, Description { mark: Feature::Seen(Mark::Brand), ..hooded() }, ActionKind::Stealing, (5, 5), 100, 90);
        o.salience = 90;
        branded.ingest(o);
        let branded_but_changed = branded.scrutiny(&Description { mark: Feature::Seen(Mark::Brand), ..changed });
        assert!(branded_but_changed > 0, "a seen brand must survive a change of clothes");
    }

    #[test]
    fn unrelated_far_crimes_open_separate_cases() {
        let mut file = CaseFile::new();
        // A hooded theft on one side of town…
        file.ingest(obs(1, hooded(), ActionKind::Stealing, (5, 5), 1_000, 60));
        // …and a DIFFERENT-looking forcing far away, much later.
        let other = Description {
            build: Feature::Seen(Build::Heavy),
            top: Feature::Seen(Hue::Black),
            bottom: Feature::Unknown,
            headwear: Feature::Seen(Headwear::Hat),
            masked: Feature::Unknown,
            gait: Feature::Unknown,
            mark: Feature::Unknown,
        };
        file.ingest(obs(2, other, ActionKind::Forcing, (40, 40), 20_000, 70));
        assert_eq!(file.cases.len(), 2, "unrelated crimes must not chain: {:#?}", file.cases);
        // A matching-hood crime near the first: merges into case 0, not 1.
        let id = file.ingest(obs(3, hooded(), ActionKind::Stealing, (7, 6), 2_500, 50));
        assert_eq!(id, Some(0));
        assert_eq!(file.cases[0].observations.len(), 2);
    }

    #[test]
    fn forensic_unknown_subject_merges_by_proximity_only() {
        let mut file = CaseFile::new();
        // The casing report is too mild to open a case: it ORPHANS.
        assert_eq!(file.ingest(obs(1, hooded(), ActionKind::Casing, (10, 10), 1_000, 60)), None);
        assert_eq!(file.cases.len(), 0);
        // The dawn discovery (same corner, inside the window) OPENS the case
        // — and the orphaned casing folds in behind it: the two facts meet.
        let id = file.ingest(obs(2, Description::UNKNOWN, ActionKind::TraceFound, (12, 10), 3_000, 90));
        assert_eq!(id, Some(0));
        assert_eq!(file.cases[0].observations.len(), 2, "the orphan must join the fresh case");
        assert_eq!(file.cases[0].profile.headwear, Feature::Seen(Headwear::Hood));
        assert!(file.orphans.is_empty());
        // The same discovery far outside the window opens its own case.
        let far = file.ingest(obs(3, Description::UNKNOWN, ActionKind::TraceFound, (45, 45), 3_100, 90));
        assert_eq!(far, Some(1));
    }

    #[test]
    fn decay_cools_cases_and_severity_slows_it() {
        let mut file = CaseFile::new();
        // Two cases: a mid-grade one (a fleeing figure) and a grave one (a body).
        file.ingest(obs(1, hooded(), ActionKind::Fleeing, (5, 5), 0, 90));
        let grave = Description { build: Feature::Seen(Build::Heavy), ..Description::UNKNOWN };
        file.ingest(obs(2, grave, ActionKind::BearingBody, (40, 40), 0, 80));
        let (petty0, grave0) = (file.cases[0].confidence, file.cases[1].confidence);
        // Phase 1 — before anything saturates: the severe case must decay
        // strictly slower per interval.
        for t in 0..15_000u64 {
            file.decay_tick(Tick(t));
        }
        let petty_lost = petty0 - file.cases[0].confidence;
        let grave_lost = grave0 - file.cases[1].confidence;
        assert!(file.cases[0].confidence > 0, "petty must not have saturated yet");
        assert!(grave_lost < petty_lost, "severity must slow decay ({grave_lost} vs {petty_lost})");
        // Phase 2 — long haul: petty goes cold, the body stays warm.
        for t in 15_000..100_000u64 {
            file.decay_tick(Tick(t));
        }
        assert!(file.cases[0].cold(), "a petty case must go cold: {}", file.cases[0].confidence);
        assert!(!file.cases[1].cold(), "a body keeps its case warm: {}", file.cases[1].confidence);
        // Cold cases exert no scrutiny (grave's Heavy-build profile conflicts
        // with the hooded look, so it contributes nothing either)…
        assert_eq!(file.scrutiny(&hooded()), 0);
        // …but re-warm on a fresh matching report (kept, not deleted).
        file.ingest(obs(3, hooded(), ActionKind::Casing, (5, 6), 100_500, 60));
        assert!(file.scrutiny(&hooded()) > 0);
        assert_eq!(file.cases.len(), 2, "the re-warmed report must fold into the old case");
    }

    /// THE M0 spike-C gate (docs/spec/12): the toy scenario hashes
    /// identically across replays, and the hash is order-sensitive.
    #[test]
    fn replay_is_bit_identical_and_order_matters() {
        let mut a = CaseFile::new();
        toy_scenario(&mut a);
        for t in 0..10_000u64 {
            a.decay_tick(Tick(t));
        }
        let mut b = CaseFile::new();
        toy_scenario(&mut b);
        for t in 0..10_000u64 {
            b.decay_tick(Tick(t));
        }
        assert_eq!(a.state_hash(), b.state_hash(), "replaying the same report stream must hash identically");
        // A different ingestion order is a DIFFERENT world (the canonical-
        // order contract is load-bearing, not incidental).
        let mut c = CaseFile::new();
        c.ingest(obs(3, Description { gait: Feature::Seen(Gait::Normal), ..hooded() }, ActionKind::Fleeing, (18, 14), 4_200, 45));
        c.ingest(obs(1, hooded(), ActionKind::Casing, (10, 10), 1_000, 60));
        c.ingest(obs(2, Description::UNKNOWN, ActionKind::TraceFound, (11, 9), 4_000, 90));
        for t in 0..10_000u64 {
            c.decay_tick(Tick(t));
        }
        assert_ne!(a.state_hash(), c.state_hash());
    }

    /// Pinned oracle: integer math end-to-end, so unlike the goo f32 oracles
    /// this constant is PORTABLE (same on every machine/binary). If this
    /// fails, correlation behaviour changed — recapture only with a reason,
    /// in the commit message (root CLAUDE.md discipline).
    #[test]
    fn state_hash_oracle_pinned() {
        let mut file = CaseFile::new();
        toy_scenario(&mut file);
        for t in 0..10_000u64 {
            file.decay_tick(Tick(t));
        }
        assert_eq!(file.state_hash(), 0x004f_269a_e9ec_1137, "recapture: {:#018x}", file.state_hash());
    }
}
